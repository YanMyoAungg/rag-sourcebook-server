import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Test files share one PostgreSQL test database; running them in
    // parallel races their truncate/seed steps.
    fileParallelism: false,
  },
});
