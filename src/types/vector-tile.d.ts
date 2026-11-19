declare module 'pbf' {
  export default class Pbf {
    constructor(buf?: Uint8Array | ArrayBuffer);
  }
}

declare module '@mapbox/vector-tile' {
  import type Pbf from 'pbf';
  export interface VectorTileFeature {
    type: 1 | 2 | 3;
    extent: number;
    properties: Record<string, string | number | boolean>;
    loadGeometry(): { x: number; y: number }[][];
  }
  export interface VectorTileLayer {
    length: number;
    feature(i: number): VectorTileFeature;
  }
  export class VectorTile {
    constructor(pbf: Pbf);
    layers: Record<string, VectorTileLayer>;
  }
}
