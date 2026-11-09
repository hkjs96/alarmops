import type { ReactNode } from "react";
import { cx } from "../cx";

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: "left" | "right";
  className?: string;
}

export interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowClassName?: (row: T) => string | undefined;
  caption?: string;
  className?: string;
}

/** Plain data table. Screens that need a phone card layout add their own `cards` class + CSS. */
export function Table<T>({ columns, rows, rowKey, rowClassName, caption, className }: TableProps<T>) {
  return (
    <div className="tw">
      <table className={cx("t", className)}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cx(c.align === "right" && "r", c.className)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} className={rowClassName?.(r)}>
              {columns.map((c) => (
                <td key={c.key} className={cx(c.align === "right" && "r", c.className)}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
