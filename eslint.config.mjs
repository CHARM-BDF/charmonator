import globals from "globals";

export default [
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.mocha,
      },
    },
    rules: {
      "no-undef": "error",
    },
  },
];
