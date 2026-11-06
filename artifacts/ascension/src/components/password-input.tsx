import { useState, type ComponentProps } from "react";
import { Eye, EyeOff } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { useI18n } from "@/lib/i18n";

/**
 * A password field with a show/hide toggle. Passwords are Latin text, so the
 * field is always LTR, also on Arabic pages.
 */
export function PasswordInput(props: Omit<ComponentProps<typeof InputGroupInput>, "type">) {
  const [visible, setVisible] = useState(false);
  const { t } = useI18n();

  return (
    <InputGroup dir="ltr">
      <InputGroupInput {...props} type={visible ? "text" : "password"} className="text-left" />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          type="button"
          aria-label={visible ? t.auth.hidePassword : t.auth.showPassword}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeOff /> : <Eye />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
