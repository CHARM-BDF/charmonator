import Ajv from 'ajv';

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
    const psrn = Math.random()  // force cache miss
    // https://community.openai.com/t/is-there-a-way-to-disable-prompt-caching-in-the-apis/973288
    return `
        We have tried to use Structured Output to decode the following JSON Response.
        However, the Response does not yet correspond to its JsonSchema.
        We have observed the ValidationErrors.
        Fix the Response so that it is fully valid according to JsonSchema, while preserving as much of its content as is reasonably possible.

        Begin by reading all the fields with enum values in the schema, noting which fields have values indicating uncertainty and acceptable for imputing null fields, such as "unknown".
        Let's call such a field value an "Uncertainty Value".
        If validation fails because a required field has string type, and enum values, and an Uncertainty Value in the field would improve validity, then impute the Uncertainty Value to the field as progress toward passing validation.
        If validation fails because a required field has string type but no enum values, delete the object containing the field to attain validity instead of populating a string such as "unknown", "Unknown" or "".


        <IgnoreThis>
        ${psrn}
        </IgnoreThis>
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
