import { and, eq, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { initiatives, objectives, projects, tasks } from "../db/schema.js";

// The task -> project -> initiative -> objective inner-join chain, org-scoped
// at every join -- originally written twice in dashboard.ts (needs-attention,
// recent-progress) and needed again by reports.ts's blockers/workstream
// queries, so it's factored out here rather than becoming a third and fourth
// copy. `extraWhere` narrows which tasks come back (a status filter, an
// updatedAt range, ...); org scoping is always applied underneath it.
export function taskParentChainQuery(db: DbOrTx, organizationId: string, extraWhere?: SQL) {
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      owner: tasks.owner,
      latestUpdate: tasks.latestUpdate,
      nextAction: tasks.nextAction,
      updatedAt: tasks.updatedAt,
      project: { id: projects.id, title: projects.title },
      initiative: { id: initiatives.id, title: initiatives.title },
      objective: { id: objectives.id, title: objectives.title },
    })
    .from(tasks)
    .innerJoin(projects, and(eq(projects.id, tasks.projectId), eq(projects.organizationId, organizationId)))
    .innerJoin(
      initiatives,
      and(eq(initiatives.id, projects.initiativeId), eq(initiatives.organizationId, organizationId)),
    )
    .innerJoin(objectives, and(eq(objectives.id, initiatives.objectiveId), eq(objectives.organizationId, organizationId)))
    .where(extraWhere ? and(eq(tasks.organizationId, organizationId), extraWhere) : eq(tasks.organizationId, organizationId));
}
