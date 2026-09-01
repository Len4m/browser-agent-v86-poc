import { array, boolean, number, object, string } from "zod";

// Keep this facade aligned with AiSdkZodLike. Importing Zod's `z` namespace
// pulls every locale and schema constructor into the lazy browser bundle.
export const zodSchemaFactory = Object.freeze({ array, boolean, number, object, string });
