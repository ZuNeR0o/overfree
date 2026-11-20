// Lenguaje LaTeX para CodeMirror 6 basado en la gramática Lezer de Overleaf.
// Adaptado de overleaf/services/web/frontend/js/features/source-editor/languages/latex/latex-language.ts
// Copyright (C) Overleaf. Licencia AGPL-3.0 (ver LICENSE).

import { LRLanguage, LanguageSupport, foldNodeProp, foldInside } from "@codemirror/language";
import { NodeProp, type SyntaxNode } from "@lezer/common";
import { styleTags, tags as t } from "@lezer/highlight";
import { parser } from "./lezer-latex/latex.mjs";
import * as terms from "./lezer-latex/latex.terms.mjs";

const tokenNames = Object.keys(terms);
export const Tokens = {
  ctrlSeq: tokenNames.filter((n) => /^(Begin|End|.*CtrlSeq)$/.test(n)),
  ctrlSym: tokenNames.filter((n) => /^.*CtrlSym$/.test(n)),
  envName: tokenNames.filter((n) => /^.*EnvName$/.test(n)),
};

const styleOverrides: Record<string, unknown> = {
  DocumentClassCtrlSeq: t.keyword,
  UsePackageCtrlSeq: t.keyword,
  CiteCtrlSeq: t.keyword,
  CiteStarrableCtrlSeq: t.keyword,
  RefCtrlSeq: t.keyword,
  RefStarrableCtrlSeq: t.keyword,
  LabelCtrlSeq: t.keyword,
};
const entries = (names: string[], def: unknown) => Object.fromEntries(names.map((n) => [n, styleOverrides[n] ?? def]));

const typeMap: Record<string, string[]> = {
  PartCtrlSeq: ["$SectioningCtrlSeq"],
  ChapterCtrlSeq: ["$SectioningCtrlSeq"],
  SectionCtrlSeq: ["$SectioningCtrlSeq"],
  SubSectionCtrlSeq: ["$SectioningCtrlSeq"],
  SubSubSectionCtrlSeq: ["$SectioningCtrlSeq"],
  ParagraphCtrlSeq: ["$SectioningCtrlSeq"],
  SubParagraphCtrlSeq: ["$SectioningCtrlSeq"],
  TextBoldCommand: ["$ToggleTextFormattingCommand"],
  TextItalicCommand: ["$ToggleTextFormattingCommand"],
};

export const LaTeXLanguage = LRLanguage.define({
  name: "latex",
  parser: parser.configure({
    props: [
      foldNodeProp.add({
        Group: foldInside,
        NonEmptyGroup: foldInside,
        TextArgument: foldInside,
        $Environment: (node: SyntaxNode) => node.getChild("Content"),
        $Section: (node: SyntaxNode) => {
          const content = node.getChild("Content");
          if (!content) return null;
          const last = node.resolveInner(node.to, -1);
          if (last.type.is(terms.NewLine)) return { from: content.from, to: last.from };
          if (last.type.is(terms.BlankLine)) return { from: content.from, to: last.to - 1 };
          return content;
        },
      }),
      NodeProp.group.add((type) => {
        const types: string[] = [];
        if (Tokens.ctrlSeq.includes(type.name) || Tokens.ctrlSym.includes(type.name)) {
          types.push("$CtrlSeq");
          if (Tokens.ctrlSym.includes(type.name)) types.push("$CtrlSym");
        } else if (Tokens.envName.includes(type.name)) {
          types.push("$EnvName");
        } else if (type.name.endsWith("Command")) {
          types.push("$Command");
        } else if (type.name.endsWith("Argument")) {
          types.push("$Argument");
          if (type.name.endsWith("TextArgument") || type.is("SectioningArgument")) types.push("$TextArgument");
        } else if (type.name.endsWith("Brace")) {
          types.push("$Brace");
        }
        if (type.name in typeMap) types.push(...typeMap[type.name]);
        return types.length ? types : undefined;
      }),
      styleTags({
        ...entries(Tokens.ctrlSeq, t.tagName),
        ...entries(Tokens.ctrlSym, t.literal),
        ...entries(Tokens.envName, t.attributeValue),
        "HrefCommand/ShortTextArgument/ShortArg/...": t.link,
        "HrefCommand/UrlArgument/...": t.monospace,
        "CtrlSeq Csname": t.tagName,
        "DocumentClass/OptionalArgument/ShortOptionalArg/...": t.attributeValue,
        "DocumentClass/ShortTextArgument/ShortArg/Normal": t.typeName,
        "ListEnvironment/BeginEnv/OptionalArgument/...": t.monospace,
        Number: t.number,
        OpenBrace: t.brace,
        CloseBrace: t.brace,
        OpenBracket: t.squareBracket,
        CloseBracket: t.squareBracket,
        Dollar: t.string,
        Math: t.string,
        "Math/MathChar": t.string,
        "Math/MathSpecialChar": t.string,
        "Math/Number": t.string,
        "MathGroup/OpenBrace MathGroup/CloseBrace": t.string,
        "MathTextCommand/TextArgument/OpenBrace MathTextCommand/TextArgument/CloseBrace": t.string,
        "MathOpening/LeftCtrlSeq MathClosing/RightCtrlSeq MathUnknownCommand/CtrlSeq MathTextCommand/CtrlSeq": t.literal,
        MathDelimiter: t.literal,
        DoubleDollar: t.keyword,
        Tilde: t.keyword,
        Ampersand: t.keyword,
        LineBreakCtrlSym: t.keyword,
        Comment: t.comment,
        "UsePackage/OptionalArgument/ShortOptionalArg/Normal": t.attributeValue,
        "UsePackage/ShortTextArgument/ShortArg/Normal": t.tagName,
        "LiteralArgContent VerbContent VerbatimContent LstInlineContent": t.string,
        "NewCommand/LiteralArgContent": t.typeName,
        "LabelArgument/ShortTextArgument/ShortArg/...": t.attributeValue,
        "RefArgument/ShortTextArgument/ShortArg/...": t.attributeValue,
        "BibKeyArgument/ShortTextArgument/ShortArg/...": t.attributeValue,
        "ShortTextArgument/ShortArg/Normal": t.monospace,
        "UrlArgument/LiteralArgContent": [t.attributeValue, t.url],
        "FilePathArgument/LiteralArgContent": t.attributeValue,
        "BareFilePathArgument/SpaceDelimitedLiteralArgContent": t.attributeValue,
        TrailingContent: t.comment,
        "Item/OptionalArgument/ShortOptionalArg/...": t.strong,
      }),
    ],
  }),
  languageData: {
    commentTokens: { line: "%" },
    closeBrackets: { brackets: ["{", "[", "(", "$"] },
  },
});

export const latex = (...extra: unknown[]) => new LanguageSupport(LaTeXLanguage, extra as never[]);
