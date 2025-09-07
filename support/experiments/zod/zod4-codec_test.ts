import { assertEquals } from "jsr:@std/assert@^1.0.0/equals";
import { z } from "npm:zod@4.1.1";

const extractorCodec = z.codec(
    z.object({
        id: z.string(),
        user: z.object({
            name: z.string(),
            email: z.string(),
            profile: z.object({
                bio: z.string(),
                age: z.number(),
            }),
        }),
        meta: z.object({
            createdAt: z.iso.datetime(),
            updatedAt: z.iso.datetime(),
        }),
        other: z.any(),
    }),
    z.object({
        id: z.string(),
        name: z.string(),
        bio: z.string(),
        createdAt: z.date(),
    }),
    {
        decode: (input) => ({
            id: input.id,
            name: input.user.name,
            bio: input.user.profile.bio,
            createdAt: new Date(input.meta.createdAt),
        }),
        encode: (output) => ({
            id: output.id,
            user: {
                name: output.name,
                email: "?????",
                profile: { bio: output.bio, age: 0 },
            },
            meta: {
                createdAt: output.createdAt.toISOString(),
                updatedAt: output.createdAt.toISOString(),
            },
            other: undefined,
        }),
    },
);

Deno.test("extractorCodec extracts and transforms complex JSON", () => {
    const input = {
        id: "42",
        user: {
            name: "Alice",
            email: "alice@example.com",
            profile: { bio: "Hello!", age: 30 },
        },
        meta: {
            createdAt: "2024-01-15T10:30:00.000Z",
            updatedAt: "2024-01-16T10:30:00.000Z",
        },
        other: "ignore me",
    };

    const extracted = z.decode(extractorCodec, input);

    assertEquals(extracted, {
        id: "42",
        name: "Alice",
        bio: "Hello!",
        createdAt: new Date("2024-01-15T10:30:00.000Z"),
    });
});
