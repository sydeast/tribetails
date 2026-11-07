package com.tribetails.auntieos.util;

import com.google.firebase.functions.FirebaseFunctionsException;

/**
 * #1592: builds a {@link FirebaseFunctionsException} with a new message.
 *
 * The SDK's constructors are Kotlin {@code internal}, so Kotlin code cannot call
 * them, but they are public in the bytecode and Java sees them. This is the one
 * place that relies on that, used by {@code forOperator()} in CallableErrorText.kt
 * to hand a screen the same exception (code, details, the original as its cause)
 * with a plain sentence for a message.
 */
final class CallableExceptionCopy {
    private CallableExceptionCopy() {}

    static FirebaseFunctionsException withMessage(FirebaseFunctionsException original, String message) {
        return new FirebaseFunctionsException(message, original.getCode(), original.getDetails(), original);
    }
}
