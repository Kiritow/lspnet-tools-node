import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierPlugin from "eslint-plugin-prettier";
import prettierConfig from "eslint-config-prettier";

export default [
    {
        ignores: ["dist/**", "node_modules/**"],
    },

    js.configs.recommended,
    ...tseslint.configs.recommended,

    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: tseslint.parser,
        },
        plugins: {
            prettier: prettierPlugin,
        },
        rules: {
            "prettier/prettier": "error",
        },
    },

    prettierConfig,
];
