// Mapbox's navigation engine ships three pre-built frameworks (MapboxCommon,
// MapboxCoreMaps, MapboxNavigationNative) inside its Swift package. Joyride
// links them through its native module rather than the app target, so Xcode
// doesn't copy them into the app on its own, and the app would quit at launch
// with "Library not loaded". These build steps copy (and sign) them.
//
// It also clears the xcframework ".signature" files Xcode 26 trips over when
// the same framework is reached through more than one package ("item already
// exists" while archiving).
const { withXcodeProject } = require('expo/config-plugins');

const EMBED = 'Embed Mapbox frameworks';
const STRIP = 'Clear xcframework signatures';

const embedScript = `set -e
DEST="\${TARGET_BUILD_DIR}/\${FRAMEWORKS_FOLDER_PATH}"
mkdir -p "$DEST"
for NAME in MapboxCommon MapboxCoreMaps MapboxNavigationNative; do
  SRC=""
  for DIR in "\${BUILT_PRODUCTS_DIR}" "\${BUILT_PRODUCTS_DIR}/PackageFrameworks"; do
    if [ -d "$DIR/$NAME.framework" ]; then SRC="$DIR/$NAME.framework"; break; fi
  done
  if [ -z "$SRC" ]; then
    SRC=$(find "\${BUILD_DIR}" -type d -name "$NAME.framework" -path "*\${EFFECTIVE_PLATFORM_NAME}*" -not -path "*.xcframework/*" 2>/dev/null | head -1)
  fi
  if [ -z "$SRC" ]; then
    echo "warning: $NAME.framework not found in build products"
    continue
  fi
  rm -rf "$DEST/$NAME.framework"
  cp -R "$SRC" "$DEST/"
  if [ -n "\${EXPANDED_CODE_SIGN_IDENTITY}" ] && [ "\${CODE_SIGNING_ALLOWED}" != "NO" ]; then
    codesign --force --sign "\${EXPANDED_CODE_SIGN_IDENTITY}" --preserve-metadata=identifier,entitlements "$DEST/$NAME.framework"
  fi
  echo "Embedded $NAME.framework"
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
        shellScript: stripScript,
      });
    }
    if (!hasPhase(project, targetUuid, EMBED)) {
      project.addBuildPhase([], 'PBXShellScriptBuildPhase', EMBED, targetUuid, {
        shellPath: '/bin/sh',
        shellScript: embedScript,
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
