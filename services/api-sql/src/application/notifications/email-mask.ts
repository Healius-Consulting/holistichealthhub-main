function text(value: unknown) {
  return value == null ? '' : String(value).trim();
}

export function enquiryDisplayFields(payload: unknown) {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const fullName = [record.firstName, record.surname].filter(value => value != null && String(value).trim()).join(' ')
    || text(record.patientName)
    || text(record.maskedName);
  return {
    name: fullName,
    phone: text(record.mobile || record.phone || record.maskedPhone),
    email: text(record.email || record.maskedEmail),
  };
}
