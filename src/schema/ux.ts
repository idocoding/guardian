import { z } from "zod";

export const uxPageSummarySchema = z.object({
  path: z.string(),
  component: z.string(),
  component_id: z.string(),
  components: z.array(z.string()),
  components_direct: z.array(z.string()),
  components_descendants: z.array(z.string()),
  components_direct_ids: z.array(z.string()),
  components_descendants_ids: z.array(z.string()),
  local_state_variables: z.array(z.string()),
  api_calls: z.array(z.string()),
  component_api_calls: z.array(
    z.object({
      component: z.string(),
      component_id: z.string(),
      api_calls: z.array(z.string())
    })
  ),
  component_state_variables: z.array(
    z.object({
      component: z.string(),
      component_id: z.string(),
      local_state_variables: z.array(z.string())
    })
  ),
  possible_navigation: z.array(z.string())
});

export const uxSnapshotSchema = z.object({
  version: z.literal("0.2"),
  components: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      file: z.string(),
      kind: z.enum(["page", "component"]),
      export_kind: z.enum(["default", "named"]),
      props: z
        .array(
          z.object({
            name: z.string(),
            type: z.string(),
            optional: z.boolean()
          })
        )
        .optional()
    })
  ),
  component_graph: z.array(
    z.object({
      from: z.string(),
      to: z.string()
    })
  ),
  pages: z.array(uxPageSummarySchema)
});
