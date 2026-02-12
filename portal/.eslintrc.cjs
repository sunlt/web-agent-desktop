/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    ecmaFeatures: {
      jsx: true,
    },
  },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  ignorePatterns: [
    "dist/",
    "node_modules/",
    "playwright-report/",
    "test-results/",
    "coverage/",
  ],
  rules: {
    "@typescript-eslint/no-empty-object-type": "off",
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      },
    ],
  },
  overrides: [
    {
      files: ["**/*.{ts,tsx}"],
      rules: {
        "max-lines": [
          "error",
          {
            max: 800,
            skipBlankLines: true,
            skipComments: false,
          },
        ],
      },
    },
  ],
};
