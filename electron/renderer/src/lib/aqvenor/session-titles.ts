import { isPlaceholderTitle } from "./store";

/* ============================================================
   Chat titles that may travel to the server at creation time.

   The server treats any non-empty title in `POST /api/conversations` as a hand
   rename: it stores `IsTitleUserDefined = true` and stops auto-titling that
   conversation for good. So the client may send a title ONLY when the person
   really typed one.

   A fresh chat is born as "New chat" (the placeholder), and a title derived
   from the first message is a local guess, not a rename. Sending either froze
   every new chat on "New chat" forever — the AQV-003 defect.
   ============================================================ */

export interface TitleCandidate {
  title?: string | null;
  titleUserDefined?: boolean;
}

/** The explicit title to create a server conversation with, or undefined to
 *  let the server keep `IsTitleUserDefined = false` and auto-title it. */
export function serverCreateTitle(session: TitleCandidate | null | undefined): string | undefined {
  if (!session?.titleUserDefined) return undefined;
  const title = session.title?.trim();
  if (!title || isPlaceholderTitle(title)) return undefined;
  return title;
}
