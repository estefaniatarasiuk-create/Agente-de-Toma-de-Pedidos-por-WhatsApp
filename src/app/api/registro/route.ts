import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { registerSchema } from "@/lib/validations/auth";

const PASSWORD_HASH_ROUNDS = 12;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Datos inválidos." },
      { status: 400 },
    );
  }

  const { companyName, email, password } = parsed.data;

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    return NextResponse.json(
      { error: "Ya existe una cuenta registrada con ese email." },
      { status: 409 },
    );
  }

  const passwordHash = await bcrypt.hash(password, PASSWORD_HASH_ROUNDS);

  await prisma.$transaction(async (tx) => {
    const company = await tx.company.create({ data: { name: companyName } });

    // El producto opera con una sola sucursal por cuenta: se crea automáticamente
    // al registrarse, con el nombre de la empresa como valor inicial editable
    // luego en Configuración (Fase 1).
    await tx.branch.create({
      data: { companyId: company.id, name: companyName },
    });

    await tx.user.create({
      data: {
        companyId: company.id,
        email,
        passwordHash,
        name: companyName,
        role: "ADMIN",
      },
    });
  });

  return NextResponse.json({ ok: true }, { status: 201 });
}
