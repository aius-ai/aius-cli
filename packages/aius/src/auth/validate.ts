// Client-side validation mirroring the AIUS backend EXACTLY (webbknd):
//   - password: auth/password_validation.py PasswordValidator
//   - email:    schemas/auth.py uses Pydantic EmailStr
//   - name:     api/auth.py requires non-empty (after strip)
// Kept in lockstep with the server so the client catches bad input up front
// with the same messages, but the server remains the source of truth.

/** Returns an error message, or null if the password is acceptable. */
export function validatePassword(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters"
  if (!/[A-Za-z]/.test(password)) return "Password must contain at least one letter"
  if (!/\d/.test(password)) return "Password must contain at least one number"
  if (!/[^A-Za-z0-9]/.test(password)) return "Password must contain at least one special character"
  return null
}

/** Returns an error message, or null if the email looks valid. */
export function validateEmail(email: string): string | null {
  const e = email.trim()
  if (!e) return "Email is required"
  if (e.length > 255) return "Email is too long (max 255 characters)"
  // Pragmatic RFC-5321-ish check; the server's EmailStr is authoritative.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return "Enter a valid email address"
  return null
}

/** Returns an error message, or null if the name is acceptable. */
export function validateName(name: string): string | null {
  const n = name.trim()
  if (!n) return "Name is required"
  if (n.length > 255) return "Name is too long (max 255 characters)"
  return null
}
