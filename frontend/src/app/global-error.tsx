"use client";

import { useEffect } from "react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { reportError } from "@/app/lib/errorReporting";
import styles from "./global-error.module.css";

export default function GlobalError({
    error,
}: {
    error: Error & { digest?: string };
}) {
    useEffect(() => {
        // The root layout itself failed: nothing else can report this one.
        reportError(error, {
            level: "fatal",
            tags: { component: "global-error-boundary", digest: error.digest },
        });
        console.error("Global error:", error);
    }, [error]);

    return (
        <html lang="en">
            <head>
                <title>Something went wrong – Mike</title>
            </head>
            <body className={styles.errorBody}>
                <div className={styles.container}>
                    <h1 className={styles.title}>Something went wrong</h1>
                    <p className={styles.message}>
                        We encountered an unexpected error. This has been logged
                        and our team will look into it.
                    </p>
                    <PillButtonUI
                        tone="blue"
                        size="normal"
                        className={styles.backButton}
                        onClick={() => window.history.back()}
                    >
                        Back
                    </PillButtonUI>
                </div>
            </body>
        </html>
    );
}
