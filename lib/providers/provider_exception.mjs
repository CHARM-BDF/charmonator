export class ProviderException extends Error {
    constructor(innerException) {
        // Pass on the message from the inner exception
        super(innerException.message);

        // Preserve the original name of this error class
        this.name = innerException.constructor.name;

        this.innerException = innerException

        // Copy the stack from the inner exception (if available)
        if (innerException.stack) {
            this.stack = innerException.stack;
        }

        // Copy the .code property if present (e.g., HTTP error code)
        if (innerException.code) {
            this.code = innerException.code;
        }

        // TODO: deduplicate vs super(...)
        if (innerException.message) {
            this.message = innerException.message;
        }

        // Optional fields that can be manually set later
        this.provider = undefined;
        this.interpretedErrorType = undefined;
        this.interpretedCode = undefined;
        this.interpretedMessage = undefined;
    }

    toString() {
        // Create an object to hold all relevant fields
        const data = {
            exception: this.name
        };

        // Add any additional properties only if defined
        if (this.provider) {
            data.provider = this.provider;
        }
        if (this.code) {
            data.code = this.code;
        }
        if (this.message) {
            data.message = this.message;
        }
        if (this.interpretedErrorType) {
            data.interpretedErrorType = this.interpretedErrorType;
        }
        if (this.interpretedCode) {
            data.interpretedCode = this.interpretedCode;
        }
        if (this.interpretedMessage) {
            data.interpretedMessage = this.interpretedMessage;
        }

        // Return a properly escaped JSON string
        return JSON.stringify(data);
    }
}

export function jsonSafeFromException(ex) {
    return (
        ex instanceof ProviderException
        ? JSON.parse(String(ex))
        : String(ex)
    )
}