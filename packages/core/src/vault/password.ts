export const MIN_VAULT_PASSWORD_LENGTH = 8;

export type PasswordStrengthLevel = "too-short" | "weak" | "fair" | "strong";

export interface PasswordStrengthResult {
  readonly level: PasswordStrengthLevel;
  readonly label: string;
  readonly valid: boolean;
}

export function evaluatePasswordStrength(password: string): PasswordStrengthResult {
  if (password.length < MIN_VAULT_PASSWORD_LENGTH) {
    return {
      level: "too-short",
      label: `Minimum ${MIN_VAULT_PASSWORD_LENGTH} characters`,
      valid: false
    };
  }

  let score = 0;
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++;

  if (score >= 4) {
    return { level: "strong", label: "Strong password", valid: true };
  }
  if (score >= 2) {
    return { level: "fair", label: "Fair password (12+ chars recommended)", valid: true };
  }
  return { level: "weak", label: "Weak password (add length or variety)", valid: true };
}
