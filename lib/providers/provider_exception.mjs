/*
Jeff's rough mental model of error handling, directed toward Charmonator providers:

    - The admittedly difficult aspiration of the providers API is to be able to write
    code portable across LLMs.  Part of LLM code is handing the errors, and since the
    vendors each do errors in a different crappy way, we try to hide discrepancies in
    error reporting to the extent we can.
    - To this end, we suppose that each provider needs to throw all known error classes
    by catching them and rethrowing a ProviderException.  If a provider fails to do so
    for a known error class, it's a bug.
    - We still need to have the innerException to tolerate the open world of
    unprecidented and unexpected exceptions.  But for known classes of exceptions,
    their use should be avoided.
    - One can argue that provider_openai.mjs is actually a combination of multiple
    providers.  It's a decent sized chunk of code at this time.  For now we have left
    e.g. Azure as inline code.  Still, we make a best-without-heroics-effort to mark
    the Azure-specific things.  Case insensitive search for "azure" in the file to see
    what's there.
    - Some of the error handling code there was things that Matt put in that I've never
    seen.  I'm sure vice versa is true.
    - The changes that I have made were mostly driven around retries, which were driven
    around failure modes I frequently saw testing budgeted summaries, which were in turn
    driven by context overflow.
    - It's often not a good idea for catch statements to catch all types, yet javascript
    encourages it.  The pattern for catching an specific exception in ES6 is apparently
    catch (err) { if (err instanceof MyCustomError) {...} else {throw err}, yet
    apparently we haven't use it yet.
    - When it's necessary to catch and rethrow a ProviderException, we don't want the
    innerException to become ProviderException, because that replaces useful information
    with useless information.  Thus:
        export class ProviderException extends Error {
            . . .
                if(innerException instanceof ProviderException) {
                    // Preserve the original name of this error class (Not ProviderException)
                    // This occurs when we explicitly throw a ProviderException and then have to rethrow.
    - Part of what makes it ok to LLM/vibe code seems to be the fact that you can run
    the LLM output and see if it crashes.  For error handling code, that's much less
    frequently true, so I try to write and test all error handling code by hand.
*/

export class ProviderException extends Error {
    constructor(innerException) {
        // Pass on the message from the inner exception
        super(innerException.message);

        if(innerException instanceof ProviderException) {
            // Preserve the original name of this error class (Not ProviderException)
            // This occurs when we explicitly throw a ProviderException and then have to rethrow.
            this.innerName = innerException.nameOfInnerException
            this.innerException = innerException.innerException
            this.stack = innerException.stack;
            this.status = innerException.status;
            this.message = innerException.message;
            this.provider = innerException.provider;
            this.interpretedErrorType = innerException.interpretedCode;
            this.interpretedCode = innerException.interpretedCode;
            this.interpretedMessage = this.interpretedMessage;
            return
        }
        this.nameOfInnerException = innerException.constructor.name;
        this.innerException = innerException

        // Copy the stack from the inner exception (if available)
        if (innerException.stack) {
            this.stack = innerException.stack;
        }

        // Copy the .status property if present (e.g., HTTP error code)
        if (innerException.status) {
            this.status = innerException.status;
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
        if (this.nameOfInnerException) {
            data.nameOfInnerException = this.nameOfInnerException;
        }
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