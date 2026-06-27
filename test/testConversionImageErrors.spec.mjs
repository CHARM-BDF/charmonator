import { strict as assert } from 'assert';

import {
  buildConversionImageErrorResponse,
  interpretedHttpStatus
} from '../routes/conversion-router.mjs';
import { ProviderException } from '../lib/providers/provider_exception.mjs';

describe('/conversion/image error handling', function() {
  it('should preserve provider-classified content filter errors as 422 responses', function() {
    const error = new ProviderException(new Error('image blocked by content safety'));
    error.provider = 'openai';
    error.interpretedErrorType = 'content_filter_violation';
    error.interpretedCode = 422;
    error.interpretedMessage = 'Content was filtered due to policy violations. Please try with different content.';

    const response = buildConversionImageErrorResponse(error);

    assert.equal(response.status, 422);
    assert.deepEqual(response.body, {
      exception: 'Error',
      nameOfInnerException: 'Error',
      provider: 'openai',
      message: 'image blocked by content safety',
      interpretedErrorType: 'content_filter_violation',
      interpretedCode: 422,
      interpretedMessage: 'Content was filtered due to policy violations. Please try with different content.'
    });
  });

  it('should fall back to 500 for unclassified errors', function() {
    const response = buildConversionImageErrorResponse(new Error('plain failure'));

    assert.equal(response.status, 500);
    assert.equal(response.body, 'Error: plain failure');
    assert.equal(interpretedHttpStatus(response.body), 500);
  });
});
