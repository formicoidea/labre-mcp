# Strategy namespace convention

> **Superseded (ARCH-04 / ARCH-25).** Ce document est conservé comme pointeur.
> La grammaire canonique des `methodId` est désormais le format **5 segments**.

Tout `methodId` de stratégie suit la grammaire :

```
domain:tool:sous-domaine:command:strategie@version
```

La référence faisant autorité est [`../architecture/ast-schema.md`](../architecture/ast-schema.md).

L'ancien format **3 segments** `<mode>:<family>:<strategy>` (ex. `write:capacity:s-curve`)
est supprimé au niveau du registre. Exemple de migration :

| Ancien (3 segments) | Nouveau (5 segments) |
|---|---|
| `write:capacity:s-curve` | `wardley:map:climate:position-functional-in-evolution:s-curve` |

Pour ajouter une stratégie, voir [extending.md](extending.md).
