export declare const adapterVersion: '1';
export declare const formats: readonly ['parquet', 'arrow', 'xlsx'];
export declare function readRows(options: { path: string; format: 'parquet' | 'arrow' | 'xlsx'; maxRows: number; maxFileBytes: number; columns: string[]; formatOptions?: { sheet?: string } }): Promise<Record<string, unknown>[]>;
