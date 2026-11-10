import type { ButtonHTMLAttributes, Ref } from "react";
import { cx } from "../cx";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  ref?: Ref<HTMLButtonElement>;
}

const VARIANT: Record<ButtonVariant, string> = { primary: "pri", secondary: "", danger: "danger", ghost: "ghost" };

/** One primary (accent) button per screen; secondary = surface + rule border; danger = secondary + red text. */
export function Button({ variant = "secondary", size = "md", className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={cx("btn", VARIANT[variant], size !== "md" && size, className)} {...rest} />;
}
