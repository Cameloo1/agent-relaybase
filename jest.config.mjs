export default {
  extensionsToTreatAsEsm: [".ts"],
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/**/*.jest.ts"],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: "tsconfig.json",
        diagnostics: { ignoreCodes: [151002] }
      }
    ]
  }
};
