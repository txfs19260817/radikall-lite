import catalog from './catalog.json' with { type: 'json' };
import type { WorkerData } from './types.ts';
const data = catalog as WorkerData;
export const { bootstrap: bootstrapData, gpsCoordinates, fullKeyBase64 } = data;
export const stationById = new Map(bootstrapData.stations.map(station => [station.id, station]));
export const allowedUpstreamHostSuffixes = ['radiko.jp', 'smartstream.ne.jp'];
