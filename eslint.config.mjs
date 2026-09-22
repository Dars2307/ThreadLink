import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    // Electron preload scripts must be CommonJS.
    files: ["**/*.cts"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    rules: {
      // Server secrets must only be read through lib/env/server.ts.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.object.name='process'][object.property.name='env'][property.name=/SECRET|DATABASE_URL/]",
          message: "Read server secrets via getServerEnv() in lib/env/server.ts.",
        },
      ],
    },
  },
  {
    rules: {
      // The RLS-bypassing client is exceptional. Any use needs review and an
      // entry in PRIVILEGED_CLIENT_ALLOWLIST (tests/client-boundary.test.ts).
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/supabase/admin", "**/supabase/admin"],
              message:
                "Privileged Supabase client bypasses RLS. Use the user-scoped client; see docs/security.md.",
            },
          ],
        },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "desktop/dist/**",
    "desktop/release/**",
    "runtime/dist/**",
  ]),
]);

export default eslintConfig;
