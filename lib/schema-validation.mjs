export function validateAgainstSchema(response, schema) {
  const ajv = new Ajv();
  const validate = ajv.compile(schema);
  const isValid = validate(response);
  if(isValid) return []
  const msgs = validate.errors
  if(!msgs || msgs.length <= 0)
    console.error("Assertion violation: !msgs || msgs.length <= 0")
  return msgs
}

export function requestToRepair(suffix, msgsError) {
    const incorrectResponse = JSON.stringify(suffix.toJSON(), null, 2);
    const validationErrors = JSON.stringify(msgsError, null, 2);
    return `
        We have tried to use Structured Output to decode the following JSON Response.
        However, the Response does not yet correspond to its JsonSchema.
        We have observed the ValidationErrors.
        Fix the Response so that it is fully valid according to JsonSchema, while preserving as much of its content as is reasonably possible.
        <Response>
        \`\`\`json
        ${incorrectResponse}
        \`\`\`
        </Response>
        <ValidationErrors>
        \`\`\`json
        ${validationErrors}
        \`\`\`
        </ValidationErrors>
    `;
}
