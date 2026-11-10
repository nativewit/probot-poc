/**
 * Trusted instruction profiles for the three review modes (§4.1):
 *
 * | mode     | profile composition                                        |
 * |----------|------------------------------------------------------------|
 * | standard | COMMON_REVIEW_INSTRUCTIONS (default flow, unchanged)        |
 * | skill    | common + SKILL_MODE_INSTRUCTIONS (+ playbook, untrusted)    |
 * | handbook | common + HANDBOOK_MODE_INSTRUCTIONS (+ guidelines, untrusted)|
 *
 * One engine, three instruction profiles: the profiles only change the
 * trusted instruction text composed around the SAME staged engine run; the
 * knowledge content itself is always untrusted data injected alongside.
 */
export { COMMON_REVIEW_INSTRUCTIONS, CONVENTIONS_INSTRUCTIONS } from "./common.js";
export { SKILL_MODE_INSTRUCTIONS } from "./skill-review.js";
export {
  HANDBOOK_MODE_INSTRUCTIONS,
  HANDBOOK_REFERENCE_INSTRUCTIONS,
} from "./handbook-review.js";
