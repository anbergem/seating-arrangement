/**
 * The controls for a venue bootstrap: an L or a U, how many tables are in each
 * of its sections, and how long each table is.
 *
 * Shared by the two places a layout can be asked for — the new-event dialog and
 * an empty floor plan — because the fields and their rules are the same in
 * both, and only the surrounding chrome differs.
 *
 * Section names are a switch over literal keys rather than a template: a
 * dynamic `t()` family has to be registered in `scripts/check-i18n-catalogs.mjs`
 * by hand, and static call sites are checked for free.
 */

import { useT } from "@agent-native/core/client/i18n";

import {
  MAX_SECTION_TABLES,
  MAX_TABLE_LENGTH,
  MIN_TABLE_SIZE,
  SECTION_COUNT,
  type LayoutKind,
} from "./geometry";

/** `none` is the new-event dialog's "start with an empty plan". */
export type LayoutChoice = LayoutKind | "none";

export interface LayoutValues {
  layout: LayoutChoice;
  /** L: `[across, down]`. U: `[leftWing, middle, rightWing]`. */
  sections: number[];
  tableLength: number;
}

/** A sensible starting arrangement for each layout. They are not padded from
 * one another: an L's `[across, down]` and a U's `[leftWing, middle,
 * rightWing]` do not line up, so carrying the numbers across would quietly turn
 * "three along the top" into "three down the left". */
const DEFAULT_SECTIONS: Readonly<Record<LayoutKind, readonly number[]>> = {
  L: [3, 2],
  U: [2, 3, 2],
};

export const DEFAULT_LAYOUT_VALUES: LayoutValues = {
  layout: "none",
  sections: [...DEFAULT_SECTIONS.L],
  tableLength: 3,
};

export interface LayoutPickerProps {
  value: LayoutValues;
  disabled: boolean;
  /** Whether "no layout" is one of the options. */
  allowNone: boolean;
  onChange: (value: LayoutValues) => void;
}

function sectionName(
  layout: LayoutKind,
  index: number,
  t: (key: string) => string,
): string {
  if (layout === "L") {
    return index === 0 ? t("seating.sectionAcross") : t("seating.sectionDown");
  }
  if (index === 0) return t("seating.sectionLeftWing");
  if (index === 1) return t("seating.sectionMiddle");
  return t("seating.sectionRightWing");
}

function numbers(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, offset) => from + offset);
}

export function LayoutPicker(props: LayoutPickerProps) {
  const t = useT();
  const { value } = props;

  /** Changing the layout resets the counts to that layout's own defaults,
   * because the positions do not mean the same thing between the two. */
  const choose = (layout: LayoutChoice) => {
    props.onChange(
      layout === "none"
        ? { ...value, layout }
        : { ...value, layout, sections: [...DEFAULT_SECTIONS[layout]] },
    );
  };

  return (
    <div className="grid gap-2">
      <label className="flex items-center justify-between gap-2 text-sm">
        {t("seating.layout")}
        <select
          className="rounded-md border bg-background px-2 py-1"
          aria-label={t("seating.layout")}
          data-testid="layout-kind"
          disabled={props.disabled}
          value={value.layout}
          onChange={(event) => choose(event.target.value as LayoutChoice)}
        >
          {props.allowNone ? (
            <option value="none">{t("seating.layoutNone")}</option>
          ) : null}
          <option value="L">{t("seating.layoutL")}</option>
          <option value="U">{t("seating.layoutU")}</option>
        </select>
      </label>

      {value.layout === "none" ? null : (
        <>
          {value.sections
            .slice(0, SECTION_COUNT[value.layout])
            .map((count, index) => {
              const name = sectionName(value.layout as LayoutKind, index, t);
              return (
                <label
                  className="flex items-center justify-between gap-2 text-sm"
                  key={`section-${index}`}
                >
                  {name}
                  <select
                    className="rounded-md border bg-background px-2 py-1"
                    aria-label={name}
                    disabled={props.disabled}
                    value={count}
                    onChange={(event) => {
                      const sections = [...value.sections];
                      sections[index] = Number(event.target.value);
                      props.onChange({ ...value, sections });
                    }}
                  >
                    {numbers(1, MAX_SECTION_TABLES).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}

          <label className="flex items-center justify-between gap-2 text-sm">
            {t("seating.layoutTableLength")}
            <select
              className="rounded-md border bg-background px-2 py-1"
              aria-label={t("seating.layoutTableLength")}
              data-testid="layout-table-length"
              disabled={props.disabled}
              value={value.tableLength}
              onChange={(event) =>
                props.onChange({
                  ...value,
                  tableLength: Number(event.target.value),
                })
              }
            >
              {numbers(MIN_TABLE_SIZE, MAX_TABLE_LENGTH).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          {/* The room grows to fit, so there is no size to work out first —
              worth saying, because it is the question the counts raise. */}
          <p className="text-xs text-muted-foreground">
            {t("seating.layoutHint")}
          </p>
        </>
      )}
    </div>
  );
}
