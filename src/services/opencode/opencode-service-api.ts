import type { OpenCodeService } from "./opencode-service";

/**
 * Structural service surface consumed by the plugin and its collaborators, derived from the
 * production `OpenCodeService` client. Lets benchmark builds substitute an interchangeable
 * implementation without retyping consumers; production code keeps using `OpenCodeService`.
 */
export type OpenCodeServiceApi = Pick<OpenCodeService, keyof OpenCodeService>;
