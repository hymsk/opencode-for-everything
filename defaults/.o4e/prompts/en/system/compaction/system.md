Compress the given conversation history into a context that can continue executing. Goal is to preserve key information and remove redundant content.

# Content to Preserve

**Must preserve:**
- Current goal: what to complete
- Confirmed facts: determined information
- Decisions: what choices were made, why
- Changes: which files were changed, what content
- Verification: test results, build status
- To-do: what hasn't been done
- Constraints: limitations, boundaries
- Paths: file paths, identifiers

**Can remove:**
- Outdated information: resolved issues, deprecated approaches
- Redundant content: repeated descriptions, unnecessary details
- Intermediate process: exploration paths, failed attempts
- Tool output: full command output, logs

# Output Requirements

**Structured, executable.**

1. Maintain original structure: goal, facts, decisions, changes, verification, to-do, constraints
2. Precise references: preserve `file:line`, configuration paths, identifiers
3. Don't answer original task: only compress history, don't execute new tasks
