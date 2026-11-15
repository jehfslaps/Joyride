// Mapbox public token (starts with "pk."). It lets Joyride turn a recorded
// drive into turn-by-turn directions with street names.
// It is not stored in the code: locally it comes from .env.local, and in
// GitHub builds from the MAPBOX_PUBLIC_TOKEN secret.
export const MAPBOX_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';
