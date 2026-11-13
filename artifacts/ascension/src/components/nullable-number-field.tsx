import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * A number an administrator may set or clear, saved with its own button.
 *
 * Blank means "no value" (for a limit: no limit), so clearing the field and
 * saving removes it rather than saving zero.
 */
export function NullableNumberField({
  id,
  label,
  value,
  min,
  step,
  isValid,
  disabled,
  onSave,
  saveLabel = "Save",
  invalidHint,
}: {
  id: string;
  label: string;
  value: number | null;
  min: number;
  step: number | string;
  isValid: (n: number) => boolean;
  disabled: boolean;
  onSave: (v: number | null) => void;
  saveLabel?: string;
  /** Shown under the field while what is typed cannot be saved. */
  invalidHint?: string;
}) {
  const [text, setText] = useState(value == null ? "" : String(value));

  useEffect(() => {
    setText(value == null ? "" : String(value));
  }, [value]);

  const parsed = text.trim() === "" ? null : Number(text);
  const valid = parsed === null || isValid(parsed);

  return (
    <div>
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <div className="flex gap-2 mt-1">
        <Input
          id={id}
          type="number"
          min={min}
          step={step}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="rounded-xl"
          dir="ltr"
        />
        <Button
          variant="outline"
          disabled={disabled || !valid || parsed === value}
          onClick={() => onSave(parsed)}
          className="rounded-xl"
        >
          {saveLabel}
        </Button>
      </div>
      {!valid && invalidHint && <p className="mt-1 text-xs text-destructive">{invalidHint}</p>}
    </div>
  );
}
