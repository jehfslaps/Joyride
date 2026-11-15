// Adds settings that can't live in app.json because they come from secrets.
// app.json holds everything else; Expo passes it in as `config`.
module.exports = ({ config }) => {
  const token = process.env.EXPO_PUBLIC_MAPBOX_TOKEN || '';
  const ios = config.ios ?? {};
  const infoPlist = ios.infoPlist ?? {};
  const modes = new Set([...(infoPlist.UIBackgroundModes ?? []), 'location', 'audio']);
  return {
    ...config,
    ios: {
      ...ios,
      infoPlist: {
        ...infoPlist,
        // Read by the Mapbox Navigation SDK.
        MBXAccessToken: token,
        // 'audio' keeps voice directions speaking while the phone is locked.
        UIBackgroundModes: [...modes],
      },
    },
  };
};
