import { taskStatusEnum } from "../db/schema.js";

// Shared by dashboard.ts's objective rollup and companyMap.ts's
// initiative/project rollups, so every level of the hierarchy renders the
// same "what's the state of everything under here" chip breakdown.
export const TASK_STATUSES = taskStatusEnum.enumValues;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskCounts = Record<TaskStatus, number>;

export function emptyTaskCounts(): TaskCounts {
  return Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as TaskCounts;
}
