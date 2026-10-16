interface PlanAnnotationRecord {
  key: string
  title: string
}

/** Plan source identity follows its coordinator and field, never the popover or Documents view displaying it. */
export function planSourceAttributes(
  conversation: number,
  record: PlanAnnotationRecord,
  field: string,
  content: string,
) {
  return {
    'data-annotation-conversation': conversation,
    'data-annotation-document': 'ultimate.plan',
    'data-annotation-record': record.key,
    'data-annotation-field': field,
    'data-annotation-title': record.title,
    'data-annotation-content': content,
  }
}
