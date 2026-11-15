# Joyride

Record your drives, relive them with turn-by-turn directions, and find fun routes.
iPhone first, with CarPlay planned.

- App: Expo (React Native) in `src/`
- Builds: `.github/workflows/ios.yml` builds the iPhone app on a GitHub Mac
- Mapbox public token: `EXPO_PUBLIC_MAPBOX_TOKEN` in `.env.local` (not committed);
  in GitHub builds it comes from the `MAPBOX_PUBLIC_TOKEN` repository secret.
