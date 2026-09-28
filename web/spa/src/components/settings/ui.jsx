import { useEffect, useRef, useState } from "preact/hooks";
import { useLocation } from "wouter-preact";

// In-app pushes carry `mobuxBack` so a back control knows the previous
// history entry is a screen of this app and can pop to it; a deep link or a
// fresh load has no such entry, so back replaces with the parent instead.
const IN_APP = { mobuxBack: true };

export function useSettingsNav() {
  const [, navigate] = useLocation();
  const push = (to) => navigate(to, { state: IN_APP });
  const back = (fallback) => {
    if (history.state && history.state.mobuxBack) {
      history.back();
      return;
    }
    navigate(fallback, { replace: true });
  };
  return { push, back };
}

export function SettingsHeader({ title, fallback }) {
  const { back } = useSettingsNav();
  return (
    <header class="app-header settings-header">
      <button
        type="button"
        class="header-back settings-back"
        aria-label="Back"
        onClick={() => back(fallback)}
      >
        ‹
      </button>
      <h1>{title}</h1>
    </header>
  );
}

export function Group({ id, title, children, ...rest }) {
  return (
    <section class="settings-group" id={id} {...rest}>
      {title && <h2>{title}</h2>}
      <div class="settings-card">{children}</div>
    </section>
  );
}

export function Lede({ children }) {
  return <p class="settings-lede">{children}</p>;
}

function Label({ label, secondary }) {
  return (
    <span class="settings-label">
      <span class="settings-title">{label}</span>
      {secondary && <small>{secondary}</small>}
    </span>
  );
}

export function NavRow({ to, label, secondary, value, row }) {
  const { push } = useSettingsNav();
  return (
    <button
      type="button"
      class="settings-row settings-row--nav"
      data-row={row}
      onClick={() => push(to)}
    >
      <Label label={label} secondary={secondary} />
      <span class="settings-trail">
        {value != null && <span class="settings-value">{value}</span>}
        <span class="settings-chevron" aria-hidden="true">
          ›
        </span>
      </span>
    </button>
  );
}

export function ActionRow({ id, label, onClick, disabled }) {
  return (
    <button
      type="button"
      id={id}
      class="settings-row settings-row--action"
      disabled={disabled}
      onClick={onClick}
    >
      <span class="settings-title">{label}</span>
    </button>
  );
}

export function SwitchRow({ name, label, secondary, checked, onChange }) {
  return (
    <label class="settings-row" data-switch={name}>
      <Label label={label} secondary={secondary} />
      <input
        type="checkbox"
        role="switch"
        class="settings-switch"
        name={name}
        checked={checked}
        aria-checked={checked ? "true" : "false"}
        onChange={onChange}
      />
    </label>
  );
}

// A row whose trailing value is the current choice; the native <select>
// covers the whole row, transparent, so a tap anywhere opens the platform
// picker.
export function SelectRow({
  id,
  rowId,
  row,
  label,
  secondary,
  value,
  options,
  onChange,
  disabled,
}) {
  const current = options.find((o) => o.value === value);
  return (
    <label class="settings-row settings-row--select" id={rowId} data-row={row}>
      <Label label={label} secondary={secondary} />
      <span class="settings-trail">
        <span class="settings-value">{current ? current.label : ""}</span>
        <span
          class="settings-chevron settings-chevron--down"
          aria-hidden="true"
        >
          ›
        </span>
      </span>
      <select
        id={id}
        class="settings-select"
        value={value}
        disabled={disabled}
        onChange={onChange}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ValueRow({ label, secondary, value, valueId, valueClass }) {
  return (
    <div class="settings-row">
      <Label label={label} secondary={secondary} />
      <span class="settings-trail">
        <span
          id={valueId}
          class={"settings-value" + (valueClass ? " " + valueClass : "")}
        >
          {value}
        </span>
      </span>
    </div>
  );
}

export function FieldRow({ rowId, label, children }) {
  return (
    <label class="settings-row settings-row--field" id={rowId}>
      <span class="settings-label">
        <span class="settings-title">{label}</span>
      </span>
      {children}
    </label>
  );
}

// label on the left, value on the right, the slider full width underneath.
// `onInput` repaints while dragging; `onCommit` fires once when the gesture
// ends (the range input's change event), which is where saving belongs.
export function SliderRow({
  id,
  valueId,
  label,
  min,
  max,
  step,
  value,
  onInput,
  onCommit,
}) {
  return (
    <label class="settings-row settings-row--slider">
      <span class="settings-slider-head">
        <span class="settings-title">{label}</span>
        <span class="settings-value" id={valueId}>
          {value.toFixed(1)}
        </span>
      </span>
      <input
        type="range"
        id={id}
        class="settings-range"
        min={min}
        max={max}
        step={step}
        value={value}
        onInput={onInput}
        onChange={onCommit}
      />
    </label>
  );
}

export function Actions({ children }) {
  return <div class="settings-actions">{children}</div>;
}

export function Button({ variant = "secondary", class: cls, ...rest }) {
  return (
    <button
      type="button"
      class={`btn btn--${variant}` + (cls ? " " + cls : "")}
      {...rest}
    />
  );
}

// Two taps: the first arms the button and relabels it, the second within the
// window runs the action. Replaces native confirm(), which a phone renders as
// a jarring system dialog.
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  variant = "danger",
  armedVariant = variant,
  ...rest
}) {
  const [armed, setArmed] = useState(false);
  const t = useRef(null);
  useEffect(() => () => clearTimeout(t.current), []);
  const onClick = () => {
    if (!armed) {
      setArmed(true);
      clearTimeout(t.current);
      t.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    clearTimeout(t.current);
    setArmed(false);
    onConfirm();
  };
  return (
    <Button
      variant={armed ? armedVariant : variant}
      data-armed={armed ? "true" : "false"}
      onClick={onClick}
      onBlur={() => setArmed(false)}
      {...rest}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}

// Status line under a card. `kind` is "ok" | "error" | undefined. An error
// longer than one line stays one ellipsised line, with the full text behind
// a Details toggle.
const LONG = 60;

export function Status({ id, status, kind, action }) {
  if (!status) return null;
  const msg = typeof status === "string" ? status : status.msg;
  const k =
    kind ??
    (typeof status === "string"
      ? undefined
      : (status.kind ?? (status.ok === false ? "error" : "ok")));
  const cls = "settings-status" + (k ? ` settings-status--${k}` : "");
  if (k === "error" && msg.length > LONG) {
    return (
      <div id={id} class={cls} role="status">
        <details class="settings-status-details">
          <summary>
            <span class="settings-status-line">{msg}</span>
            <span class="settings-status-more">Details</span>
          </summary>
          <p class="settings-status-full">{msg}</p>
        </details>
      </div>
    );
  }
  return (
    <div
      id={id}
      class={cls + (action ? " settings-status--action" : "")}
      role="status"
    >
      <span class="settings-status-line">{msg}</span>
      {action && (
        <Button
          id={action.id}
          variant="primary"
          class="btn--inline"
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
