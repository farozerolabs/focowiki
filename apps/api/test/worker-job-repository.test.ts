import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryPath = resolve(import.meta.dirname, "../src/db/worker-job-repository.ts");
const migrationPath = resolve(import.meta.dirname, "../migrations/001_production_admin_web.sql");

function readRepository(): string {
  return readFileSync(repositoryPath, "utf8").replace(/\s+/g, " ").toLowerCase();
}

function readMigration(): string {
  return readFileSync(migrationPath, "utf8").replace(/\s+/g, " ").toLowerCase();
}

describe("worker job repository contract", () => {
  it("claims jobs with indexed queue-only locking and deterministic bounded ordering", () => {
    const repository = readRepository();

    expect(repository).toContain("from focowiki.worker_jobs");
    expect(repository).toContain("where kind = any(${input.kinds})");
    expect(repository).toContain("run_after <= ${input.now}");
    expect(repository).toContain("coalesce(heartbeat_at, locked_at) < ${input.stalebefore}");
    expect(repository).toContain("order by run_after asc, created_at asc, id asc");
    expect(repository).toContain("limit ${input.limit}");
    expect(repository).toContain("for update skip locked");
    expect(repository).not.toContain("status = 'cancelled' or");
    expect(repository).not.toContain(" offset ");
  });

  it("cancels queued source-file jobs through explicit source-file IDs", () => {
    const repository = readRepository();
    const cancelSection = repository.slice(
      repository.indexOf("async cancelqueuedsourcefilejobs"),
      repository.indexOf("async releaseworkerjob")
    );

    expect(cancelSection).toContain("kind = 'source_file_processing'");
    expect(cancelSection).toContain("knowledge_base_id = ${input.knowledgebaseid}");
    expect(cancelSection).toContain("source_file_id = any(${input.sourcefileids})");
    expect(cancelSection).toContain("status = 'queued'");
    expect(cancelSection).toContain("status = 'cancelled'");
    expect(cancelSection).not.toContain("status = 'running'");
  });

  it("summarizes queue state through materialized status reads and indexed oldest queued lookup", () => {
    const repository = readRepository();

    expect(repository).toContain("from focowiki.worker_queue_summaries");
    expect(repository).toContain("sum(job_count) as count");
    expect(repository).toContain("group by status");
    expect(repository).toContain("select min(run_after) as oldest_queued_at");
    expect(repository).toContain("from focowiki.worker_jobs");
    expect(repository).toContain("and knowledge_base_id = ${input.knowledgebaseid}");
    expect(repository).toContain("and status = 'queued'");
    expect(repository).toContain("createqueuesummary");
  });

  it("prevents duplicate active source-file and publication jobs with stable active predicates", () => {
    const repository = readRepository();
    const sourceSection = repository.slice(
      repository.indexOf("async enqueuesourcefilejob"),
      repository.indexOf("async enqueuepublicationjob")
    );
    const publicationSection = repository.slice(
      repository.indexOf("async enqueuepublicationjob"),
      repository.indexOf("async claimworkerjobs")
    );

    expect(sourceSection).toContain("where not exists");
    expect(sourceSection).toContain("kind = 'source_file_processing'");
    expect(sourceSection).toContain("source_file_id = ${input.sourcefileid}");
    expect(sourceSection).toContain("status in ('queued', 'running')");
    expect(sourceSection).toContain("order by created_at asc, id asc");
    expect(sourceSection).toContain("limit 1");

    expect(publicationSection).toContain("where not exists");
    expect(publicationSection).toContain("kind = 'publication'");
    expect(publicationSection).toContain("knowledge_base_id = ${input.knowledgebaseid}");
    expect(publicationSection).toContain("status in ('queued', 'running')");
    expect(publicationSection).toContain("order by run_after asc, created_at asc, id asc");
    expect(publicationSection).toContain("limit 1");
  });

  it("prevents duplicate active hard-delete jobs without source-file foreign keys", () => {
    const repository = readRepository();
    const hardDeleteSection = repository.slice(
      repository.indexOf("async enqueueharddeletejob"),
      repository.indexOf("async claimworkerjobs")
    );

    expect(hardDeleteSection).toContain("'hard_delete'");
    expect(hardDeleteSection).toContain("source_file_id");
    expect(hardDeleteSection).toContain("null");
    expect(hardDeleteSection).toContain("payload_json->>'targetkind' = 'knowledge_base'");
    expect(hardDeleteSection).toContain("payload_json->>'targetkind' = 'source_file'");
    expect(hardDeleteSection).toContain("payload_json->>'sourcefileid'");
    expect(hardDeleteSection).toContain("status in ('queued', 'running')");
    expect(hardDeleteSection).toContain("order by run_after asc, created_at asc, id asc");
  });

  it("keeps hard-delete restart, duplicate, and multi-worker claim semantics bounded", () => {
    const repository = readRepository();
    const claimSection = repository.slice(
      repository.indexOf("async claimworkerjobs"),
      repository.indexOf("async completeworkerjob")
    );
    const hardDeleteSection = repository.slice(
      repository.indexOf("async enqueueharddeletejob"),
      repository.indexOf("async claimworkerjobs")
    );

    expect(hardDeleteSection).toContain("where not exists");
    expect(hardDeleteSection).toContain("status in ('queued', 'running')");
    expect(hardDeleteSection).toContain("payload_json->>'targetkind' = 'knowledge_base'");
    expect(hardDeleteSection).toContain("payload_json->>'targetkind' = 'source_file'");
    expect(hardDeleteSection).toContain("payload_json->>'sourcefileid'");

    expect(claimSection).toContain("status = 'running'");
    expect(claimSection).toContain("coalesce(heartbeat_at, locked_at) < ${input.stalebefore}");
    expect(claimSection).toContain("for update skip locked");
    expect(claimSection).toContain("locked_by = ${input.workerid}");
    expect(claimSection).toContain("attempt_count = job.attempt_count + 1");
  });

  it("cancels queued knowledge-base child work without cancelling the scope delete job", () => {
    const repository = readRepository();
    const cancelSection = repository.slice(
      repository.indexOf("async cancelqueuedknowledgebasejobs"),
      repository.indexOf("async releaseworkerjob")
    );

    expect(cancelSection).toContain("knowledge_base_id = ${input.knowledgebaseid}");
    expect(cancelSection).toContain("status = 'queued'");
    expect(cancelSection).toContain("kind in ('source_file_processing', 'publication')");
    expect(cancelSection).toContain("payload_json->>'targetkind'");
    expect(cancelSection).toContain("<> 'knowledge_base'");
    expect(cancelSection).not.toContain("status = 'running'");
  });

  it("keeps delete-time cancellation scoped to queued child work", () => {
    const repository = readRepository();
    const sourceCancelSection = repository.slice(
      repository.indexOf("async cancelqueuedsourcefilejobs"),
      repository.indexOf("async releaseworkerjob")
    );
    const knowledgeBaseCancelSection = repository.slice(
      repository.indexOf("async cancelqueuedknowledgebasejobs"),
      repository.indexOf("async releaseworkerjob")
    );

    expect(sourceCancelSection).toContain("kind = 'source_file_processing'");
    expect(sourceCancelSection).toContain("status = 'queued'");
    expect(sourceCancelSection).toContain("status = 'cancelled'");
    expect(sourceCancelSection).not.toContain("status = 'running'");

    expect(knowledgeBaseCancelSection).toContain("kind in ('source_file_processing', 'publication')");
    expect(knowledgeBaseCancelSection).toContain("kind = 'hard_delete'");
    expect(knowledgeBaseCancelSection).toContain("<> 'knowledge_base'");
    expect(knowledgeBaseCancelSection).toContain("status = 'queued'");
    expect(knowledgeBaseCancelSection).toContain("status = 'cancelled'");
    expect(knowledgeBaseCancelSection).not.toContain("status = 'running'");
  });

  it("keeps cancelled queued jobs valid when a deferred job already has a start timestamp", () => {
    const repository = readRepository();
    const sourceCancelSection = repository.slice(
      repository.indexOf("async cancelqueuedsourcefilejobs"),
      repository.indexOf("async releaseworkerjob")
    );
    const knowledgeBaseCancelSection = repository.slice(
      repository.indexOf("async cancelqueuedknowledgebasejobs"),
      repository.indexOf("async releaseworkerjob")
    );

    for (const section of [sourceCancelSection, knowledgeBaseCancelSection]) {
      expect(section).toContain("completed_at = greatest(");
      expect(section).toContain("${input.cancelledat}");
      expect(section).toContain("coalesce(started_at, ${input.cancelledat})");
    }
  });

  it("moves running jobs through retry, failure, dead-letter, heartbeat, and completion by worker ownership", () => {
    const repository = readRepository();
    const failSection = repository.slice(
      repository.indexOf("async failworkerjob"),
      repository.indexOf("async deadletterworkerjob")
    );
    const deadLetterSection = repository.slice(
      repository.indexOf("async deadletterworkerjob"),
      repository.indexOf("async heartbeatworkerjob")
    );
    const heartbeatSection = repository.slice(
      repository.indexOf("async heartbeatworkerjob"),
      repository.indexOf("async recordworkerheartbeat")
    );
    const completeSection = repository.slice(
      repository.indexOf("async completeworkerjob"),
      repository.indexOf("async failworkerjob")
    );
    const releaseSection = repository.slice(
      repository.indexOf("async releaseworkerjob"),
      repository.indexOf("async heartbeatworkerjob")
    );

    expect(failSection).toContain("status = ${willretry ? \"queued\" : \"failed\"}");
    expect(failSection).toContain("run_after = coalesce(${input.retryafter}, run_after)");
    expect(failSection).toContain("failed_at = ${willretry ? null : input.failedat}");
    expect(failSection).toContain("and locked_by = ${input.workerid}");
    expect(failSection).toContain("and status = 'running'");

    expect(deadLetterSection).toContain("status = 'dead_letter'");
    expect(deadLetterSection).toContain("failed_at = ${input.failedat}");
    expect(deadLetterSection).toContain("and locked_by = ${input.workerid}");
    expect(deadLetterSection).toContain("and status = 'running'");

    expect(releaseSection).toContain("status = 'queued'");
    expect(releaseSection).toContain("locked_by = null");
    expect(releaseSection).toContain("heartbeat_at = null");
    expect(releaseSection).toContain("run_after = coalesce(${input.runafter ?? null}, run_after)");
    expect(releaseSection).toContain("and locked_by = ${input.workerid}");
    expect(releaseSection).toContain("and status = 'running'");

    expect(heartbeatSection).toContain("heartbeat_at = ${input.heartbeatat}");
    expect(heartbeatSection).toContain("and locked_by = ${input.workerid}");
    expect(heartbeatSection).toContain("and status = 'running'");

    expect(completeSection).toContain("status = 'completed'");
    expect(completeSection).toContain("completed_at = ${input.completedat}");
    expect(completeSection).toContain("last_error_code = null");
    expect(completeSection).toContain("and locked_by = ${input.workerid}");
    expect(completeSection).toContain("and status = 'running'");
  });

  it("retains only bounded completed, failed, dead-letter, and cancelled history", () => {
    const repository = readRepository();
    const cleanupSection = repository.slice(
      repository.indexOf("async cleanupworkerjobs"),
      repository.indexOf("async countactiveworkerjobs")
    );

    expect(cleanupSection).toContain("delete from focowiki.worker_jobs job");
    expect(cleanupSection).toContain("status = 'completed'");
    expect(cleanupSection).toContain("status = 'failed'");
    expect(cleanupSection).toContain("status = 'dead_letter'");
    expect(cleanupSection).toContain("status = 'cancelled'");
    expect(cleanupSection).toContain("limit ${input.limit}");
    expect(cleanupSection).not.toContain("status = 'queued'");
    expect(cleanupSection).not.toContain("status = 'running'");
  });

  it("defines indexes for claim, active duplicate prevention, summary, and retention reads", () => {
    const migration = readMigration();

    for (const index of [
      "worker_jobs_claim_idx",
      "worker_jobs_kind_status_idx",
      "worker_jobs_hard_delete_active_idx",
      "worker_jobs_queued_oldest_idx",
      "worker_jobs_running_heartbeat_idx",
      "worker_jobs_source_active_idx",
      "worker_jobs_source_cancel_idx",
      "worker_jobs_publication_active_idx",
      "worker_jobs_kb_created_idx",
      "worker_jobs_retention_idx",
      "worker_heartbeats_seen_idx",
      "worker_queue_summaries_kind_status_idx"
    ]) {
      expect(migration).toContain(index);
    }
    expect(migration).toContain("create table if not exists focowiki.worker_queue_summaries");
    expect(migration).toContain("create trigger worker_jobs_summary_sync_trigger");
    expect(migration).toContain("create table if not exists focowiki.hard_delete_object_deletions");
    expect(migration).toContain("hard_delete_object_deletions_job_pending_idx");
  });
});
