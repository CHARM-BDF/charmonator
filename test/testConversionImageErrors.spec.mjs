import { strict as assert } from 'assert';

import {
  buildConversionImageErrorResponse,
  interpretedHttpStatus
} from '../routes/conversion-router.mjs';
import { ProviderException } from '../lib/providers/provider_exception.mjs';
import { imageToMarkdown } from '../lib/core.mjs';
import { useManagedServerFixture } from './support/managed-server-fixture.mjs';

const TEST_IMAGE_DATA_URL = 'data:image/png;base64,dGVzdC1pbWFnZS1ieXRlcw==';

describe('/conversion/image error handling', function() {
  useManagedServerFixture();

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

  it('should rethrow structured provider errors from the loopback client as ProviderException', async function() {
    let thrown = null;

    try {
      await imageToMarkdown({
        imageUrl: TEST_IMAGE_DATA_URL,
        describe: false,
        model: 'test-policy-conversion-image-content-filter'
      });
    } catch (error) {
      thrown = error;
    }

    assert(thrown instanceof ProviderException);
    assert.equal(thrown.provider, 'openai');
    assert.equal(thrown.message, 'image blocked by content safety');
    assert.equal(thrown.interpretedErrorType, 'content_filter_violation');
    assert.equal(thrown.interpretedCode, 422);
    assert.equal(thrown.interpretedMessage, 'Content was filtered due to policy violations. Please try with different content.');
    assert.equal(thrown.status, 422);
  });
});
