import Link from "next/link";

// Public (no sign-in) privacy notice for Exvade Pulse, linked from the
// Google sign-in consent screen.
export const metadata = { title: "Privacy — Exvade Pulse" };

const UPDATED = "September 29, 2026";
const CONTACT = "sean@exvadebio.com";

export default function PrivacyPage() {
  return (
    <main className="page guide">
      <p>
        <Link href="/">&larr; Back to Pulse</Link>
      </p>
      <div className="header">
        <h1>Exvade Pulse privacy notice</h1>
      </div>
      <p className="muted">Last updated {UPDATED}</p>

      <div className="card">
        <p>
          Exvade Pulse is an internal operations tool run by Exvade Bioscience for its own team and invited collaborators. It is
          not a public service: only people an Exvade administrator has invited can sign in.
        </p>

        <h2 className="section-title">What we collect</h2>
        <ul>
          <li>
            <strong>Google sign-in:</strong> your name, email address and profile picture, used only to identify you and check
            that you&rsquo;ve been invited.
          </li>
          <li>
            <strong>Gmail (only if an administrator connects it):</strong> read-only access to the connected mailbox, used to
            turn operational emails into proposed updates. Pulse never sends, deletes or changes email.
          </li>
          <li>
            <strong>Work content:</strong> the tasks, decisions, notes, meeting summaries and documents your team adds to Pulse.
          </li>
        </ul>

        <h2 className="section-title">How it&rsquo;s used</h2>
        <ul>
          <li>Only to run Pulse for Exvade: organizing work, proposing updates, and producing reviews and reports.</li>
          <li>
            Content is processed by Anthropic&rsquo;s Claude API to draft proposed updates. Patient identifiers are removed before
            anything is stored or analyzed, and every AI suggestion is reviewed by a person before it changes anything.
          </li>
          <li>We don&rsquo;t sell data, use it for advertising, or share it with anyone outside the service providers below.</li>
        </ul>

        <h2 className="section-title">Where it&rsquo;s stored</h2>
        <p>
          Pulse runs on Vercel (website), Render (server) and Neon (database), with AI processing by Anthropic. Access is
          limited to invited users, and restricted records are visible only to administrators.
        </p>

        <h2 className="section-title">Your choices</h2>
        <p>
          An administrator can remove your access at any time, and you can revoke Pulse&rsquo;s Google access from your Google
          Account&rsquo;s security settings. Admins can also give someone temporary, password-protected read-only access for a
          review; those links expire on their own, can be switched off at any time, and can never change anything. To ask about or request deletion of your data, contact{" "}
          <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        </p>
      </div>
    </main>
  );
}
