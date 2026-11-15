// The scripts avoid backslashes, and their newlines are written as "\\n",
// because the Xcode project file treats both specially.
const forPbx = (script) => script.replace(/\n/g, '\\n');

// Mapbox's navigation engine comes as a Swift package whose libraries
// (MapboxCommon, MapboxCoreMaps, MapboxNavigationNative, Turf, …) Joyride
// links through its native module rather than the app target, so Xcode
// doesn't copy them into the app on its own, and the app would quit at launch
// with "Library not loaded". This build step finds every such library the app
// loads and copies (and signs) it into the app.
//
// It also clears the xcframework ".signature" files Xcode 26 trips over when
// the same framework is reached through more than one package ("item already
// exists" while archiving).
const { withXcodeProject } = require('expo/config-plugins');

const EMBED = 'Embed Mapbox frameworks';
const STRIP = 'Clear xcframework signatures';

const embedScript = `set -e
# Copies every framework the app (or an embedded framework) loads through
# @rpath that isn't in the app yet, looking in the build products folders.
DEST="\${TARGET_BUILD_DIR}/\${FRAMEWORKS_FOLDER_PATH}"
APP_BIN="\${TARGET_BUILD_DIR}/\${EXECUTABLE_PATH}"
mkdir -p "$DEST"

find_framework() {
  for DIR in "\${BUILT_PRODUCTS_DIR}" "\${BUILT_PRODUCTS_DIR}/PackageFrameworks"; do
    if [ -d "$DIR/$1.framework" ]; then echo "$DIR/$1.framework"; return; fi
  done
  find "\${BUILD_DIR}" -type d -name "$1.framework" -path "*\${EFFECTIVE_PLATFORM_NAME}*" -not -path "*.xcframework/*" -not -path "*.app/*" 2>/dev/null | head -1
}

for PASS in 1 2 3 4 5; do
  ADDED=0
  BINS="$APP_BIN"
  for FW in "$DEST"/*.framework; do
    [ -d "$FW" ] || continue
    N=$(basename "$FW" .framework)
    [ -f "$FW/$N" ] && BINS="$BINS
$FW/$N"
  done
  NEEDED=$(echo "$BINS" | while read -r B; do otool -L "$B" 2>/dev/null; done \
    | awk '{print $1}' | grep '^@rpath/' | grep '[.]framework/' | cut -d/ -f2 | sed 's/[.]framework$//' | sort -u)
  for NAME in $NEEDED; do
    [ -d "$DEST/$NAME.framework" ] && continue
    SRC=$(find_framework "$NAME")
    if [ -z "$SRC" ]; then
      echo "warning: $NAME.framework is needed but wasn't found in build products"
      continue
    fi
    cp -R "$SRC" "$DEST/"
    if [ -n "\${EXPANDED_CODE_SIGN_IDENTITY}" ] && [ "\${CODE_SIGNING_ALLOWED}" != "NO" ]; then
      codesign --force --sign "\${EXPANDED_CODE_SIGN_IDENTITY}" --preserve-metadata=identifier,entitlements "$DEST/$NAME.framework"
    fi
    echo "Embedded $NAME.framework"
    ADDED=1
  done
  [ "$ADDED" = 1 ] || break
done
`;

const stripScript = `ROOT="\${BUILD_DIR%/Build/*}"
find "$ROOT" -name "*.xcframework-*.signature" -delete 2>/dev/null
exit 0
`;

function hasPhase(project, targetUuid, name) {
  const target = project.pbxNativeTargetSection()[targetUuid];
  const scripts = project.hash.project.objects.PBXShellScriptBuildPhase || {};
  return (target.buildPhases || []).some((p) => scripts[`${p.value}_comment`] === name || p.comment === name);
}

module.exports = function withMapboxEmbed(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const targetUuid = project.getFirstTarget().uuid;
    if (!hasPhase(project, targetUuid, STRIP)) {
      project.addBuildPhase([], 'PBXShellScriptBuildPhase', STRIP, targetUuid, {
        shellPath: '/bin/sh',
        shellScript: forPbx(stripScript),
      });
    }
    if (!hasPhase(project, targetUuid, EMBED)) {
      project.addBuildPhase([], 'PBXShellScriptBuildPhase', EMBED, targetUuid, {
        shellPath: '/bin/sh',
        shellScript: forPbx(embedScript),
      });
    }
    // Run every time; Xcode can't see these files as inputs.
    const scripts = project.hash.project.objects.PBXShellScriptBuildPhase || {};
    for (const [key, phase] of Object.entries(scripts)) {
      if (typeof phase !== 'object') continue;
      const name = (phase.name || '').replace(/"/g, '');
      if (name === EMBED || name === STRIP) phase.alwaysOutOfDate = 1;
    }
    return cfg;
  });
};
