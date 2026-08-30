/**
 * Text-decoding helpers shared by every reader that parses a file a user
 * may have produced by hand.
 */

/**
 * Drop a leading UTF-8 byte-order mark.
 *
 * `readFile(path, 'utf8')` keeps U+FEFF, and `JSON.parse` rejects it, so a
 * document saved by PowerShell (`>`, `Out-File`, `Set-Content -Encoding
 * utf8` all emit one), Notepad, or VS Code's "UTF-8 with BOM" fails to
 * parse for a reason nothing in the error message reveals. Windows users hit
 * this on the OTLP import path and on hand-written config; Linux CI never
 * does, because nothing there writes a BOM.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
