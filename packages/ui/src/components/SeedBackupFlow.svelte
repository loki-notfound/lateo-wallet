<script lang="ts">
  import {
    pickSeedQuizIndices,
    splitMnemonicWords,
    verifySeedQuizAnswers,
    type RestoreHeightSource
  } from "@lateo-wallet/core/vault";

  interface Props {
    seed: string;
    restoreHeight: number;
    restoreHeightSource: RestoreHeightSource;
    createdAt: string;
    busy?: boolean;
    onVerified: () => Promise<void>;
  }

  let {
    seed,
    restoreHeight,
    restoreHeightSource,
    createdAt,
    busy = false,
    onVerified
  }: Props = $props();

  let step = $state<"display" | "quiz">("display");
  let quizIndices = $state<readonly number[]>([]);
  let quizAnswers = $state<Record<number, string>>({});
  let quizError = $state<string | null>(null);
  let submitting = $state(false);

  const words = $derived(splitMnemonicWords(seed));
  const createdDateUtc = $derived(createdAt.slice(0, 10));
  const blankSlots = Array.from({ length: 25 }, (_, i) => i + 1);

  function startQuiz(): void {
    const picked = pickSeedQuizIndices(words.length, 3);
    quizIndices = picked;
    quizAnswers = {};
    quizError = null;
    step = "quiz";
  }

  function printBlankSheet(): void {
    window.print();
  }

  function updateAnswer(pos: number, value: string): void {
    quizAnswers = { ...quizAnswers, [pos]: value };
  }

  async function submitQuiz(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    quizError = null;
    const check = verifySeedQuizAnswers(words, quizIndices, quizAnswers);
    if (!check.passed) {
      quizError = `Word ${check.wrongIndices.join(", ")} did not match. Check your backup and try again.`;
      return;
    }
    submitting = true;
    try {
      await onVerified();
    } catch (err) {
      quizError = err instanceof Error ? err.message : "Could not record backup verification";
    } finally {
      submitting = false;
    }
  }
</script>

<!-- Screen view (hidden when printing so live words never go to a printer) -->
<section class="lt-panel lt-stack lt-screen-only" data-testid="seed-backup-panel">
  <div class="lt-panel-header">
    <div>
      <h1 class="lt-panel-title">
        {step === "display" ? "Back up your 25-word recovery seed" : "Verify your backup (3 words)"}
      </h1>
      <p class="lt-panel-subtitle">
        Record both the 25 words and the restore height together.
      </p>
    </div>
  </div>

  <div class="lt-callout lt-callout-danger" role="note">
    <p class="lt-callout-title">Keep this 25-word seed offline</p>
    <p>
      Anyone with these words can spend all funds across every Zephyr asset. Never type a seed
      phrase into a website, support chat, or online form.
    </p>
  </div>

  <div class="lt-meta-pills">
    <span class="lt-tx-badge lt-tx-pending" data-testid="backup-restore-height">
      Restore height: {restoreHeight}
    </span>
    <span class="lt-tx-badge" data-testid="backup-created-date">
      Date (UTC): {createdDateUtc}
    </span>
    {#if restoreHeightSource === "daemon"}
      <span class="lt-tx-badge lt-tx-confirmed" data-testid="backup-height-source">
        Live daemon height
      </span>
    {:else}
      <span class="lt-tx-badge lt-tx-locked" data-testid="backup-height-source">
        Offline estimate (node unreachable)
      </span>
    {/if}
  </div>

  {#if step === "display"}
    <ol class="lt-seed-grid" data-testid="seed-word-grid">
      {#each words as word, idx (idx)}
        <li class="lt-seed-item" data-word-index={idx + 1}>
          <span class="lt-seed-num">{String(idx + 1).padStart(2, "0")}</span>
          <code class="lt-seed-word"><bdi>{word}</bdi></code>
        </li>
      {/each}
    </ol>

    <div class="lt-callout lt-callout-info">
      <p>
        <strong>Blank backup sheet:</strong> Printing outputs 25 empty numbered boxes to fill in
        by hand — your live words are hidden from the printer.
      </p>
    </div>

    <div class="lt-form-actions">
      <button
        type="button"
        class="lt-btn lt-btn-primary"
        disabled={busy}
        onclick={startQuiz}
        data-testid="start-quiz-btn"
      >
        I wrote down my seed — verify 3 words
      </button>
      <button
        type="button"
        class="lt-btn lt-btn-secondary"
        onclick={printBlankSheet}
        data-testid="print-blank-btn"
      >
        Print blank backup sheet
      </button>
    </div>
  {:else}
    {#if quizError}
      <div class="lt-alert lt-alert-danger" role="alert" data-testid="quiz-error">
        <div class="lt-alert-body">{quizError}</div>
      </div>
    {/if}

    <form onsubmit={submitQuiz} class="lt-stack" data-testid="seed-quiz-form">
      {#each quizIndices as pos (pos)}
        <div class="lt-field">
          <label class="lt-label" for={`quiz-word-${pos}`}>
            Word #{pos}<span class="lt-required">*</span>
          </label>
          <input
            id={`quiz-word-${pos}`}
            class="lt-input"
            type="text"
            value={quizAnswers[pos] ?? ""}
            oninput={(e) => updateAnswer(pos, (e.currentTarget as HTMLInputElement).value)}
            autocomplete="off"
            spellcheck="false"
            required
            disabled={submitting || busy}
            data-testid={`quiz-input-${pos}`}
            data-quiz-pos={pos}
          />
        </div>
      {/each}

      <div class="lt-form-actions">
        <button
          type="submit"
          class="lt-btn lt-btn-primary"
          disabled={submitting || busy}
          data-testid="verify-quiz-btn"
        >
          {submitting ? "Verifying..." : "Confirm backup & continue"}
        </button>
        <button
          type="button"
          class="lt-btn lt-btn-secondary"
          disabled={submitting || busy}
          onclick={() => {
            step = "display";
            quizError = null;
          }}
        >
          Back to seed
        </button>
      </div>
    </form>
  {/if}
</section>

<!-- Print-only blank backup sheet (empty boxes; live words never printed) -->
<section class="lt-backup-sheet lt-print-only" aria-hidden="true" data-testid="blank-backup-sheet">
  <div class="lt-backup-header">
    <div>
      <h1>Lateo Wallet — Offline Recovery Backup Sheet</h1>
      <p class="lt-muted">Fill in by hand using pen. Store offline in a secure location.</p>
    </div>
  </div>
  <div class="lt-backup-meta-grid">
    <div class="lt-backup-field">
      <span class="lt-backup-field-label">Wallet name</span>
      <span class="lt-backup-line"></span>
    </div>
    <div class="lt-backup-field">
      <span class="lt-backup-field-label">Network (Mainnet / Testnet / Stagenet)</span>
      <span class="lt-backup-line"></span>
    </div>
    <div class="lt-backup-field">
      <span class="lt-backup-field-label">Restore height</span>
      <span class="lt-backup-line"></span>
    </div>
    <div class="lt-backup-field">
      <span class="lt-backup-field-label">Creation date (UTC)</span>
      <span class="lt-backup-line"></span>
    </div>
  </div>
  <ol class="lt-backup-grid">
    {#each blankSlots as slot (slot)}
      <li class="lt-backup-slot">
        <span class="lt-backup-slot-num">{String(slot).padStart(2, "0")}</span>
        <span class="lt-backup-slot-line"></span>
      </li>
    {/each}
  </ol>
  <div class="lt-backup-notes">
    <span class="lt-backup-field-label">Notes</span>
  </div>
</section>
