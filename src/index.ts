export { normalizeDataset, ticksFromPrice, priceFromTicks } from './data/normalize.js';
export { importDataset, setFormatAdapter, type ImportDatasetOptions } from './data/import.js';
export { applyFrames } from './data/frames.js';
export { parseFramePreparation } from './spec/validate.js';
export { framesPreparationSchema, framesPreparationJsonSchema } from './spec/schema.js';
export { encodeDataset, decodeDataset } from './data/serialize.js';
export { runBacktest, validateBacktest, ENGINE_VERSION } from './engine/run.js';
export { parseSpec, validateDatasetMetadata, backtestSpecJsonSchema, metadataJsonSchema } from './spec/validate.js';
export { BacktestError, errorJSON } from './spec/errors.js';
export { canonicalJSON, contentHash } from './spec/canonical.js';
export type * from './spec/types.js';

export { runSweep, parseSweepRequest, type SweepRequest, type SweepResult, type ResearchHooks, type ParameterSpace, type Objective } from './research/sweep.js';
export { runWalkForward, parseWalkForwardRequest, type WalkForwardRequest, type WalkForwardResult } from './research/walk-forward.js';
export { factorDiagnostics, parseFactorRequest, type FactorRequest, type FactorResult } from './research/factors.js';

export { renderReport } from './reports/html.js';
export { queryStudy, readStudyManifest, type StudyQuery, type StudyPage, type StudyManifest } from './runtime/research-results.js';
