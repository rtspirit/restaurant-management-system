import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { cx } from "../cx";
import { Icon } from "../icons";

type NativeInput = Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "style" | "children">;

export type TextFieldProps = NativeInput & {
  label: string;
  /** One short line under the label: what to type, in plain words. */
  hint?: string;
  /** What is wrong and how to fix it, in plain words. Shown in heavy ink with a mark, never a colour. */
  error?: string;
  /** Right-aligned figures for money and counts. */
  money?: boolean;
  /** The question is already on screen as a heading (QuestionForm), so do not print the label again. */
  hideLabel?: boolean;
};

export function TextField({ label, hint, error, money = false, hideLabel = false, id, ...rest }: TextFieldProps) {
  const auto = useId();
  const fieldId = id ?? auto;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="rms-field">
      {hideLabel ? null : (
        <label className="rms-field__label" htmlFor={fieldId}>
          {label}
        </label>
      )}
      {hint ? (
        <span className="rms-field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      <input
        {...(hideLabel ? { "aria-label": label } : {})}
        {...rest}
        id={fieldId}
        className={cx("rms-input", money && "rms-input--money")}
        aria-invalid={error ? true : undefined}
        aria-describedby={[describedBy, rest["aria-describedby"]].filter(Boolean).join(" ") || undefined}
        {...(money ? { inputMode: "decimal" as const } : {})}
      />
      {error ? (
        <span className="rms-field__error" id={errorId} role="alert">
          <Icon name="alert" />
          {error}
        </span>
      ) : null}
    </div>
  );
}

type NativeSelect = Omit<SelectHTMLAttributes<HTMLSelectElement>, "className" | "style" | "children">;

export type SelectOption = { value: string; label: string };

export type SelectProps = NativeSelect & {
  /** Always needed. Hidden from sight with `hideLabel` when the choice explains itself. */
  label: string;
  hideLabel?: boolean;
  options: SelectOption[];
  hint?: string;
  block?: boolean;
};

/** The platform's own picker, so it works with a thumb, a keyboard and a screen reader. */
export function Select({ label, hideLabel = false, options, hint, block = false, id, ...rest }: SelectProps) {
  const auto = useId();
  const fieldId = id ?? auto;
  const hintId = hint ? `${fieldId}-hint` : undefined;

  const control = (
    <span className={cx("rms-select", block && "rms-select--block")}>
      <select
        {...rest}
        id={fieldId}
        className="rms-select__control"
        aria-describedby={hintId}
        {...(hideLabel ? { "aria-label": label } : {})}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="rms-select__chevron">
        <Icon name="down" />
      </span>
    </span>
  );

  if (hideLabel && !hint) return control;

  return (
    <div className="rms-field">
      {hideLabel ? null : (
        <label className="rms-field__label" htmlFor={fieldId}>
          {label}
        </label>
      )}
      {hint ? (
        <span className="rms-field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {control}
    </div>
  );
}

export type FieldPairProps = { children: ReactNode };

/** Two short fields side by side where there is room, stacked where there is not. */
export function FieldPair({ children }: FieldPairProps) {
  return <div className="rms-form__pair">{children}</div>;
}
