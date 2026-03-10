module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true,
    browser: true
  },
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  ignorePatterns: ["**/dist/**", "**/.next/**", "**/node_modules/**"],
  overrides: [
    {
      files: ["apps/demo-ui/**/*.{ts,tsx}"],
      extends: ["next/core-web-vitals"]
    }
  ]
};
