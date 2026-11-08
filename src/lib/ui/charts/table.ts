/** A chart's table twin (ChartTable.svelte): the same numbers as the plot, formatted. */
export interface ChartTableColumn {
	label: string;
	unit?: string;
}

export interface ChartTableRow {
	label: string;
	/** One per column, formatted; null when there is no value. */
	values: readonly (string | null)[];
	/** The week (or month) in progress: not complete, marked 'so far'. */
	inProgress?: boolean;
}

export interface ChartTableData {
	/** The header over the row labels: 'Week'. */
	rowHeader: string;
	columns: readonly ChartTableColumn[];
	rows: readonly ChartTableRow[];
}
