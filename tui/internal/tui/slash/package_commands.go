package slash

import (
	"strings"
	"unicode"
)

func commandRootIs(content string, expected string) bool {
	content = strings.TrimLeftFunc(content, unicode.IsSpace)
	if len(content) < len(expected) || !strings.EqualFold(content[:len(expected)], expected) {
		return false
	}
	return len(content) == len(expected) || unicode.IsSpace(rune(content[len(expected)]))
}

func parseCreatePackageCommand(raw string, content string) (ParsedCommand, error) {
	input := strings.TrimSpace(content[len("create-package"):])
	parser := packageSyntaxParser{input: []rune(input)}
	members, name, err := parser.parse()
	if err != nil {
		return ParsedCommand{}, err
	}
	return ParsedCommand{
		Raw:         raw,
		Kind:        KindCreatePackage,
		PackageName: name,
		Members:     members,
	}, nil
}

type packageSyntaxParser struct {
	input []rune
	pos   int
}

func (p *packageSyntaxParser) parse() ([]string, string, error) {
	p.skipSpace()
	if !p.consume('{') {
		return nil, "", packageSyntaxError()
	}
	p.skipSpace()
	if p.peek('}') {
		return nil, "", ParseError{Message: "A package must contain at least one quoted registered app name."}
	}

	members := []string{}
	for {
		member, err := p.quoted("Package members must be quoted registered app names.")
		if err != nil {
			return nil, "", err
		}
		if strings.TrimSpace(member) == "" {
			return nil, "", ParseError{Message: "Package members cannot be empty."}
		}
		members = append(members, member)
		p.skipSpace()
		if p.consume('}') {
			break
		}
		if !p.consume(',') {
			return nil, "", ParseError{Message: "Separate quoted package members with commas."}
		}
		p.skipSpace()
		if p.peek('}') {
			return nil, "", ParseError{Message: "A package member is required after the final comma."}
		}
	}

	p.skipSpace()
	name, err := p.quoted("Package name must be quoted.")
	if err != nil {
		return nil, "", err
	}
	if strings.TrimSpace(name) == "" {
		return nil, "", ParseError{Message: "Package name cannot be empty."}
	}
	p.skipSpace()
	if p.pos != len(p.input) {
		return nil, "", ParseError{Message: "Unexpected text after the package name."}
	}
	return members, name, nil
}

func (p *packageSyntaxParser) quoted(message string) (string, error) {
	p.skipSpace()
	if p.pos >= len(p.input) || (p.input[p.pos] != '\'' && p.input[p.pos] != '"') {
		return "", ParseError{Message: message}
	}
	quote := p.input[p.pos]
	p.pos++
	var value strings.Builder
	for p.pos < len(p.input) {
		current := p.input[p.pos]
		p.pos++
		if current == quote {
			return value.String(), nil
		}
		if current == '\\' {
			if p.pos >= len(p.input) {
				return "", ParseError{Message: "Close the quoted package value before submitting the command."}
			}
			next := p.input[p.pos]
			if next == quote || next == '\\' {
				p.pos++
				value.WriteRune(next)
				continue
			}
		}
		value.WriteRune(current)
	}
	return "", ParseError{Message: "Close the quoted package value before submitting the command."}
}

func (p *packageSyntaxParser) skipSpace() {
	for p.pos < len(p.input) && unicode.IsSpace(p.input[p.pos]) {
		p.pos++
	}
}

func (p *packageSyntaxParser) consume(value rune) bool {
	if p.pos >= len(p.input) || p.input[p.pos] != value {
		return false
	}
	p.pos++
	return true
}

func (p *packageSyntaxParser) peek(value rune) bool {
	return p.pos < len(p.input) && p.input[p.pos] == value
}

func packageSyntaxError() ParseError {
	return ParseError{Message: "Use /create-package {'Registered App','Other App'} 'package-name'."}
}
