/** Explicitly selectable skill metadata; manual-only skills remain available to the picker. */
export type SkillPickerSkill = {
  name: string
  description: string
  path: string
  disableModelInvocation: boolean
}
