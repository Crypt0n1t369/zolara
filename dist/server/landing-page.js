export function landingPageHtml() {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Zolara — private Telegram alignment rounds</title>
  <meta name="description" content="Zolara privately asks members what they think in Telegram, then synthesizes agreement, tensions, blind spots, and next steps." />
  <style>
    :root { color-scheme: light; --ink:#111827; --muted:#5b6472; --line:#e5e7eb; --wash:#f8fafc; --accent:#4f46e5; --accent2:#0f766e; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:var(--ink); background:#fff; line-height:1.55; }
    main { max-width:1120px; margin:0 auto; padding:28px 20px 64px; }
    section { padding:56px 0; border-bottom:1px solid var(--line); }
    .hero { padding-top:72px; }
    .eyebrow { color:var(--accent2); font-weight:700; text-transform:uppercase; letter-spacing:.08em; font-size:.78rem; }
    h1 { font-size:clamp(2.4rem, 7vw, 5.8rem); line-height:.95; letter-spacing:-.06em; margin:16px 0; max-width:900px; }
    h2 { font-size:clamp(1.8rem, 4vw, 3rem); line-height:1.05; letter-spacing:-.035em; margin:0 0 18px; }
    h3 { margin:0 0 8px; font-size:1.15rem; }
    p { color:var(--muted); font-size:1.05rem; max-width:760px; }
    .lede { font-size:1.3rem; color:#374151; max-width:820px; }
    .cta { display:flex; gap:12px; flex-wrap:wrap; margin-top:28px; align-items:center; }
    .button { display:inline-block; padding:13px 18px; border-radius:999px; text-decoration:none; font-weight:800; border:1px solid var(--line); color:var(--ink); }
    .button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
    form { margin-top:24px; display:grid; gap:12px; max-width:520px; }
    input, select { width:100%; padding:13px 14px; border:1px solid var(--line); border-radius:14px; font:inherit; }
    label { font-weight:800; color:#374151; }
    .field-note { font-size:.85rem; color:var(--muted); margin-top:-6px; }
    .micro { font-size:.9rem; color:var(--muted); margin-top:10px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:18px; margin-top:28px; }
    .card { background:var(--wash); border:1px solid var(--line); border-radius:22px; padding:22px; }
    .card p, li { font-size:.98rem; color:var(--muted); }
    ul { padding-left:1.2rem; }
    .steps { counter-reset:step; }
    .step { position:relative; padding-left:52px; }
    .step:before { counter-increment:step; content:counter(step); position:absolute; left:0; top:20px; width:32px; height:32px; border-radius:50%; display:grid; place-items:center; background:#eef2ff; color:var(--accent); font-weight:900; }
    details { border:1px solid var(--line); border-radius:16px; padding:16px 18px; background:#fff; }
    details + details { margin-top:10px; }
    summary { cursor:pointer; font-weight:800; }
    footer { padding-top:32px; color:var(--muted); }
  </style>
</head>
<body>
<main>
  <section class="hero">
    <div class="eyebrow">For communities too large for town halls and too human for surveys</div>
    <h1>Stop running your community on whoever showed up.</h1>
    <p class="lede">Zolara runs private Telegram listening rounds and synthesizes what your whole community actually thinks — before backlash, burnout, or another meeting dominated by the usual voices.</p>
    <div class="cta">
      <a class="button primary" href="#connect">Connect Telegram</a>
      <a class="button" href="#workflow">See the Telegram workflow</a>
    </div>
    <div class="micro">No new app for members. No public confrontation. No 90-minute meeting required.</div>
  </section>

  <section>
    <h2>Less chasing. Less guessing. Fewer legitimacy fights.</h2>
    <p>The issue is not that members do not care. Current tools only hear the people with time, confidence, and proximity to speak up.</p>
    <div class="grid">
      <div class="card"><h3>Town halls miss the majority</h3><p>Every member gets a private Telegram prompt and can answer asynchronously.</p></div>
      <div class="card"><h3>Group chat loses signal</h3><p>Replies become structured themes, tensions, blockers, and next steps.</p></div>
      <div class="card"><h3>Organizers carry the process</h3><p>Zolara handles asking, reminding, validating, clustering, and synthesis.</p></div>
      <div class="card"><h3>Quiet members stay invisible</h3><p>Members can contribute privately without performing a public position.</p></div>
    </div>
  </section>

  <section>
    <h2>Built for five high-signal community roles</h2>
    <div class="grid">
      <div class="card"><h3>Marta — Community Manager</h3><p>Make decisions with evidence, not hallway noise. Hear all 200 members without putting them in one room.</p></div>
      <div class="card"><h3>Jānis — Festival Organizer</h3><p>Turn group-chat chaos into an idea map, volunteer signal, risks, and post-event memory.</p></div>
      <div class="card"><h3>Leo — Quiet Member</h3><p>Participate without performing: no meeting, no public argument, two thoughtful questions in Telegram.</p></div>
      <div class="card"><h3>Ava — Veteran Steward</h3><p>Make invisible contribution visible and preserve institutional memory without creating hierarchy.</p></div>
      <div class="card"><h3>Emergency Coordinator</h3><p>Turn spontaneous volunteers into structured intake, operational pulse checks, and safer handovers.</p></div>
    </div>
  </section>

  <section id="workflow">
    <h2>How Zolara works</h2>
    <div class="grid steps">
      <div class="card step"><h3>Choose the topic</h3><p>Start with a decision, event, policy, pulse check, intake, or debrief.</p></div>
      <div class="card step"><h3>Ask better questions</h3><p>Zolara turns the topic into focused prompts instead of a shallow yes/no poll.</p></div>
      <div class="card step"><h3>Members reply privately</h3><p>People answer in Telegram on their own time, without public performance.</p></div>
      <div class="card step"><h3>Clarify and synthesize</h3><p>Ambiguous replies can be validated, then clustered into common ground, tensions, blind spots, and next steps.</p></div>
      <div class="card step"><h3>React and act</h3><p>The group marks aligned, want-to-discuss, or disagree. Meetings focus only on unresolved tension.</p></div>
    </div>
  </section>

  <section>
    <h2>FAQ</h2>
    <details open><summary>Is this just another survey?</summary><p>No. Zolara runs a loop: private prompt → clarification → synthesis → group report → reactions → next action.</p></details>
    <details><summary>Do members need a new app?</summary><p>No. Zolara is Telegram-native, so members answer where coordination already happens.</p></details>
    <details><summary>Is input anonymous?</summary><p>Rounds can be anonymous, attributed, or mixed. The default promise is that input shapes themes without putting someone on stage.</p></details>
    <details><summary>Does AI make the decision?</summary><p>No. Zolara structures signal so humans can decide better. Leadership and the community still make the call.</p></details>
  </section>

  <section id="connect">
    <h2>Connect your Telegram account.</h2>
    <p>Tell Zolara your email and Telegram username. Then open <strong>@Zolara_bot</strong> and send <strong>hi</strong>. Telegram requires you to message the bot first; after that Zolara can bind this profile to your stable Telegram ID.</p>
    <form method="post" action="/intake">
      <label>Email<input name="email" type="email" autocomplete="email" required placeholder="you@example.org" /></label>
      <label>Telegram username<input name="telegramUsername" autocomplete="username" required placeholder="@yourusername" /></label>
      <label>Role<select name="role"><option value="lead">I’m setting up a project</option><option value="member">I’m joining a project</option></select></label>
      <button class="button primary" type="submit">Save profile and open Telegram</button>
      <div class="field-note">Usernames can change; this is only a temporary lookup until you message the bot.</div>
    </form>
  </section>

  <footer>Copy source: <code>docs/landing-page.md</code></footer>
</main>
</body>
</html>`;
}
