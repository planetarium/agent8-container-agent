/**
 * Container Module Exports
 *
 * This module provides the container-side implementation for Agent8 GitLab integration.
 * Containers use these components to execute tasks and report results autonomously.
 */

export {
  ContainerTaskReporter,
  createTaskEndpoint,
  type GitLabInfo,
  type TaskPayload,
  type TaskResult
} from './containerTaskReporter.js';
